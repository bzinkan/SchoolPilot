const empty = () => ({ fullUploads: 0, fullUploadBytes: 0, referenceUploads: 0,
  referenceMisses: 0, metadataOnlyReads: 0, deltaUploads: 0, deltaUploadBytes: 0, deltaMaterializedBytes: 0,
  deltaBaseReadBytes: 0, deltaMisses: 0, deltaReads: 0, deltaReadBytes: 0 });

/** Fixed-size process aggregates; no image IDs, content hashes or tenant labels. */
export class ScreenshotImageActivity {
  private counts = empty();
  record(kind: 'full' | 'reference' | 'miss' | 'metadata_read' | 'delta_upload' | 'delta_base_read' | 'delta_miss' | 'delta_read', value = 0, materialized = 0): void {
    if (kind === 'full') {
      this.counts.fullUploads++;
      this.counts.fullUploadBytes += Number.isFinite(value) ? Math.max(0, value) : 0;
    } else if (kind === 'reference') this.counts.referenceUploads++;
    else if (kind === 'miss') this.counts.referenceMisses++;
    else if (kind === 'metadata_read') this.counts.metadataOnlyReads += Number.isFinite(value) ? Math.max(0, value) : 0;
    else if (kind === 'delta_upload') {
      this.counts.deltaUploads++;
      this.counts.deltaUploadBytes += Number.isFinite(value) ? Math.max(0, value) : 0;
      this.counts.deltaMaterializedBytes += Number.isFinite(materialized) ? Math.max(0, materialized) : 0;
    } else if (kind === 'delta_base_read') this.counts.deltaBaseReadBytes += Number.isFinite(value) ? Math.max(0, value) : 0;
    else if (kind === 'delta_miss') this.counts.deltaMisses++;
    else if (kind === 'delta_read') {
      this.counts.deltaReads++;
      this.counts.deltaReadBytes += Number.isFinite(value) ? Math.max(0, value) : 0;
    }
  }
  flush() {
    const result = this.counts;
    this.counts = empty();
    return result;
  }
}
