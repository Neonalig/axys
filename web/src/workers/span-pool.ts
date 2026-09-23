// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A pool of span workers that measures an analysis's frames one span at a time.
 *
 * Spans queue until a worker is free, so a take split into more spans than there are workers
 * keeps every worker busy and reports progress as each span lands.
 */

import { WorkerCancelled } from './protocol';
import type { ObserveSpanRequest, RequestId, SpanMeasures, SpanResponse } from './protocol';

/** One span of frames to measure, without the pool's own request fields. */
export type Span = Omit<ObserveSpanRequest, 'type' | 'id'>;

interface Task {
  /** The analysis the span belongs to, so a cancelled analysis can drop its spans. */
  job: RequestId;
  span: Span;
  resolve(measures: SpanMeasures): void;
  reject(error: Error): void;
}

/** Measures spans across a fixed set of span workers. */
export class SpanPool {
  readonly #idle: Worker[] = [];
  readonly #queue: Task[] = [];
  readonly #running = new Map<RequestId, { task: Task; worker: Worker }>();
  #workers = 0;
  #nextId = 1;

  private constructor(size: number) {
    for (let index = 0; index < size; index++) {
      const worker = new Worker(new URL('./span.worker.ts', import.meta.url), {
        type: 'module',
        name: `axys-span-${index + 1}`,
      });
      worker.addEventListener('message', (event: MessageEvent<SpanResponse>) => {
        this.#receive(worker, event.data);
      });
      worker.addEventListener('error', (event) => {
        event.preventDefault();
        this.#lose(worker, event.message || 'a span worker stopped');
      });
      this.#idle.push(worker);
      this.#workers += 1;
    }
  }

  /** Starts `size` span workers, or returns `null` when there are none to start. */
  static create(size: number): SpanPool | null {
    if (size < 1 || typeof Worker !== 'function') return null;
    try {
      return new SpanPool(size);
    } catch {
      return null;
    }
  }

  /** Has every span worker load its core now rather than on its first span. */
  warm(): void {
    for (const worker of this.#idle) worker.postMessage({ type: 'warm' });
  }

  /** Workers still running. */
  get size(): number {
    return this.#workers;
  }

  /**
   * Measures one span of analysis `job`.
   *
   * @remarks The span's window is transferred to the worker and unusable afterwards.
   */
  observe(job: RequestId, span: Span): Promise<SpanMeasures> {
    return new Promise<SpanMeasures>((resolve, reject) => {
      if (this.#workers === 0) {
        reject(new Error('no span workers are running'));
        return;
      }
      this.#queue.push({ job, span, resolve, reject });
      this.#pump();
    });
  }

  /**
   * Rejects every span of analysis `job` with {@link WorkerCancelled}.
   *
   * @remarks A span already running finishes and its result is discarded.
   */
  drop(job: RequestId): void {
    for (let index = this.#queue.length - 1; index >= 0; index--) {
      const task = this.#queue[index];
      if (task?.job !== job) continue;
      this.#queue.splice(index, 1);
      task.reject(new WorkerCancelled('Analyse Audio'));
    }
    for (const { task } of this.#running.values()) {
      if (task.job === job) task.reject(new WorkerCancelled('Analyse Audio'));
    }
  }

  #pump(): void {
    while (this.#idle.length > 0 && this.#queue.length > 0) {
      const worker = this.#idle.pop();
      const task = this.#queue.shift();
      if (worker === undefined || task === undefined) return;
      const id = this.#nextId++;
      this.#running.set(id, { task, worker });
      const request: ObserveSpanRequest = { type: 'observeSpan', id, ...task.span };
      try {
        worker.postMessage(request, [task.span.window.buffer]);
      } catch (thrown) {
        this.#running.delete(id);
        this.#idle.push(worker);
        task.reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
      }
    }
  }

  #receive(worker: Worker, message: SpanResponse): void {
    const running = this.#running.get(message.id);
    if (running === undefined) return;
    this.#running.delete(message.id);
    this.#idle.push(worker);
    if (message.type === 'observed') {
      running.task.resolve(message.measures);
    } else {
      running.task.reject(new Error(message.message));
    }
    this.#pump();
  }

  /** Retires a worker that stopped, failing its span and, once none are left, every queued one. */
  #lose(worker: Worker, reason: string): void {
    worker.terminate();
    this.#workers -= 1;
    const idle = this.#idle.indexOf(worker);
    if (idle >= 0) this.#idle.splice(idle, 1);
    for (const [id, running] of this.#running) {
      if (running.worker !== worker) continue;
      this.#running.delete(id);
      running.task.reject(new Error(reason));
    }
    if (this.#workers > 0) return;
    for (const task of this.#queue.splice(0)) task.reject(new Error(reason));
  }
}
