const empty = () => ({ fullUploads: 0, fullUploadBytes: 0, referenceUploads: 0,
  referenceMisses: 0, metadataOnlyReads: 0 });

/** Fixed-size process aggregates; no image IDs, content hashes or tenant labels. */
export class ScreenshotImageActivity {
  private counts = empty();
  record(kind: 'full' | 'reference' | 'miss' | 'metadata_read', value = 0): void {
    if (kind === 'full') {
      this.counts.fullUploads++;
      this.counts.fullUploadBytes += Number.isFinite(value) ? Math.max(0, value) : 0;
    } else if (kind === 'reference') this.counts.referenceUploads++;
    else if (kind === 'miss') this.counts.referenceMisses++;
    else if (kind === 'metadata_read') this.counts.metadataOnlyReads += Number.isFinite(value) ? Math.max(0, value) : 0;
  }
  flush() {
    const result = this.counts;
    this.counts = empty();
    return result;
  }
}
