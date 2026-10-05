/** In-memory photos only; never persist private proof in the query cache. */
export class RetainedUploadPhotos {
  private photos = new Map<string, Promise<string | null>>();

  capture(key: string, take: () => Promise<string | null>): Promise<string | null> {
    const retained = this.photos.get(key);
    if (retained) return retained;
    const pending = take().then((uri) => {
      if (!uri && this.photos.get(key) === pending) this.photos.delete(key);
      return uri;
    }, (error: unknown) => {
      if (this.photos.get(key) === pending) this.photos.delete(key);
      throw error;
    });
    this.photos.set(key, pending);
    return pending;
  }

  forget(key: string): void { this.photos.delete(key); }
  clear(): void { this.photos.clear(); }
}
