// Tiny publish/subscribe so the server can push "something changed" to every open window.
export type Listener = (event: unknown) => void;

export class Bus {
  private subs = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.subs.add(listener);
    return () => this.subs.delete(listener);
  }

  publish(event: unknown): void {
    for (const listener of [...this.subs]) listener(event);
  }
}
