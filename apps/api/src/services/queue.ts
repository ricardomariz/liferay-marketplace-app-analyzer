export type AsyncJob = () => Promise<void>;

export class InMemoryQueue {
  private readonly jobs: AsyncJob[] = [];
  private running = false;

  enqueue(job: AsyncJob) {
    this.jobs.push(job);
    void this.runNext();
  }

  get size() {
    return this.jobs.length + (this.running ? 1 : 0);
  }

  private async runNext() {
    if (this.running) {
      return;
    }

    const nextJob = this.jobs.shift();

    if (!nextJob) {
      return;
    }

    this.running = true;

    try {
      await nextJob();
    } finally {
      this.running = false;
      void this.runNext();
    }
  }
}
