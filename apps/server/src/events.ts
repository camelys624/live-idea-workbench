import { EventEmitter } from 'node:events';
import type { WorkbenchEvent } from '@workbench/contracts';

/** 进程内事件总线（单节点部署）。只在事务提交后发布。 */
export class EventHub {
  readonly #emitter = new EventEmitter().setMaxListeners(0);

  publish(events: WorkbenchEvent[]): void {
    for (const event of events) this.#emitter.emit('event', event);
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    this.#emitter.on('event', listener);
    return () => this.#emitter.off('event', listener);
  }
}
