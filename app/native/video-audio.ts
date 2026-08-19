declare const android: any;

/**
 * Phone-side MP4 audio clock. Android routes this through the current media
 * output automatically (speaker, Bluetooth headphones, etc.). The player has
 * no Surface, so the MP4 video track is not shown on the phone.
 */
export class VideoAudioClock {
  private player: any | null = null;
  private prepared = false;
  private duration = 0;

  prepare(path: string): number {
    this.release();
    const player = new android.media.MediaPlayer();
    const attributes = new android.media.AudioAttributes.Builder()
      .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
      .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MOVIE)
      .build();
    player.setAudioAttributes(attributes);
    player.setDataSource(path);
    player.prepare();
    this.player = player;
    this.prepared = true;
    this.duration = Math.max(0, Number(player.getDuration()) || 0);
    return this.duration;
  }

  get durationMs(): number {
    return this.duration;
  }

  get currentPositionMs(): number {
    if (!this.player || !this.prepared) return 0;
    try {
      return Math.max(0, Number(this.player.getCurrentPosition()) || 0);
    } catch {
      return 0;
    }
  }

  get isPlaying(): boolean {
    if (!this.player || !this.prepared) return false;
    try {
      return Boolean(this.player.isPlaying());
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.player && this.prepared && !this.isPlaying) this.player.start();
  }

  pause(): void {
    if (this.player && this.prepared && this.isPlaying) this.player.pause();
  }

  seekTo(positionMs: number): void {
    if (!this.player || !this.prepared) return;
    const clamped = Math.max(0, Math.min(this.duration || positionMs, Math.round(positionMs)));
    this.player.seekTo(clamped);
  }

  release(): void {
    if (!this.player) return;
    try {
      this.player.stop();
    } catch {
      // stop() is illegal before/after some MediaPlayer states; release still succeeds.
    }
    try {
      this.player.release();
    } finally {
      this.player = null;
      this.prepared = false;
      this.duration = 0;
    }
  }
}
