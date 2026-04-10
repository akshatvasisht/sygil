/**
 * Simple async mutex to serialize git worktree operations that fight over
 * `.git/index.lock`. Only `git worktree add` and `git worktree remove`
 * need this — normal git operations within a worktree are safe to run
 * concurrently.
 */
export class WorktreeMutex {
  private locked = false;
  private readonly queue: Array<() => void> = [];

  /**
   * Acquire the mutex. Returns a release function that must be called
   * when the protected operation completes.
   *
   * Waiters are served in FIFO order.
   */
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return this.createRelease();
    }

    // Wait in line
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        resolve(this.createRelease());
      });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = this.queue.shift();
      if (next) {
        // Hand lock to next waiter
        next();
      } else {
        this.locked = false;
      }
    };
  }
}
