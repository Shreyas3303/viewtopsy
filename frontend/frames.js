/*
 * Grabs still frames from a local video file, entirely in the browser.
 * The file never leaves the computer: it is played through an object URL and
 * frames are drawn onto a canvas.
 */
(function (root) {
  "use strict";

  /**
   * Frames cover LOOK_BACK seconds before chat starts rising to the end of that
   * first rising window. Chat reacts a few seconds after the cause (stream
   * delay plus reading and typing), so the cause is usually in this span.
   */
  const LOOK_BACK = 25;
  const FRAMES_PER_MOMENT = 8;

  class FrameGrabber {
    constructor(file) {
      this.file = file;
      this.url = URL.createObjectURL(file);
      this.video = document.createElement("video");
      this.video.muted = true;
      this.video.preload = "auto";
      this.video.playsInline = true;
      this.video.src = this.url;
      this.queue = Promise.resolve();
      this.ready = new Promise((resolve, reject) => {
        this.video.addEventListener("loadedmetadata", () => resolve(this.video.duration), { once: true });
        this.video.addEventListener("error", () => reject(new Error(
          "This browser can't play that video file. MP4 (H.264) works best; TwitchDownloader's default .mp4 is fine.",
        )), { once: true });
      });
    }

    get duration() {
      return this.video.duration;
    }

    /** Seeks to `seconds` and returns a JPEG data URL `width` pixels wide. Calls are queued. */
    grab(seconds, width = 480) {
      const job = this.queue.then(() => this.ready).then(() => new Promise((resolve, reject) => {
        const video = this.video;
        const target = Math.min(Math.max(0, seconds), Math.max(0, video.duration - 0.05));
        const timer = setTimeout(() => reject(new Error("Timed out reading the video")), 15000);
        const done = () => {
          clearTimeout(timer);
          try {
            const height = Math.round((video.videoHeight / video.videoWidth) * width) || Math.round(width * 9 / 16);
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            canvas.getContext("2d").drawImage(video, 0, 0, width, height);
            resolve(canvas.toDataURL("image/jpeg", 0.8));
          } catch (error) {
            reject(error);
          }
        };
        if (Math.abs(video.currentTime - target) < 0.01 && video.readyState >= 2) {
          done();
        } else {
          video.addEventListener("seeked", done, { once: true });
          video.currentTime = target;
        }
      }));
      this.queue = job.catch(() => {});
      return job;
    }

    dispose() {
      URL.revokeObjectURL(this.url);
      this.video.removeAttribute("src");
      this.video.load();
    }
  }

  /**
   * Stream times to capture for a moment. Spacing gets tighter toward the
   * point where chat starts rising, where the cause most often is.
   * @param onsetTime when chat started rising (stream seconds)
   */
  function frameTimes(onsetTime, windowSeconds, count = FRAMES_PER_MOMENT) {
    const start = onsetTime - LOOK_BACK;
    const end = onsetTime + windowSeconds * 0.8;
    return Array.from({ length: count }, (_, i) => start + (end - start) * Math.sqrt(i / (count - 1)));
  }

  root.ViewtopsyFrames = { FrameGrabber, frameTimes, LOOK_BACK, FRAMES_PER_MOMENT };
})(typeof self !== "undefined" ? self : this);
