import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../../components/ui/button";
import { Maximize, Minimize, X, ZoomIn, ZoomOut, RotateCcw, Camera } from "lucide-react";
import { useToast } from "../../../hooks/use-toast";

function VideoPortal({ stream, studentName, onClose, onStopLiveView }) {
  const videoContainerRef = useRef(null);
  const videoRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const { toast } = useToast();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream || null;
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream]);

  const handleFullscreen = async () => {
    const videoContainer = videoContainerRef.current;
    if (!videoContainer) return;

    try {
      if (!document.fullscreenElement) {
        await videoContainer.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.warn('Fullscreen error:', error);
    }
  };

  const handlePictureInPicture = async () => {
    const video = videoRef.current;
    if (!video) return;

    try {
      if (document.pictureInPictureEnabled && !document.pictureInPictureElement) {
        await video.requestPictureInPicture();
      } else if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      }
    } catch (error) {
      console.warn('Picture-in-Picture error:', error);
    }
  };

  const handleScreenshot = () => {
    const video = videoRef.current;
    if (!video) {
      toast({
        variant: "destructive",
        title: "Screenshot failed",
        description: "No video found",
      });
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const context = canvas.getContext('2d');
      if (!context) throw new Error('Failed to get canvas context');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob((blob) => {
        if (!blob) {
          toast({
            variant: "destructive",
            title: "Screenshot failed",
            description: "Failed to create image",
          });
          return;
        }

        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${studentName}_screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);

        toast({
          title: "Screenshot captured",
          description: `Saved screenshot of ${studentName}'s screen`,
        });
      }, 'image/png');
    } catch (error) {
      console.warn('Screenshot error:', error);
      toast({
        variant: "destructive",
        title: "Screenshot failed",
        description: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const handleStopLiveView = () => {
    onStopLiveView?.();
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      data-testid="video-portal-overlay"
    >
      <div
        className="relative w-full max-w-7xl rounded-2xl bg-neutral-900 p-4 shadow-2xl dark:bg-neutral-950"
        onClick={(event) => event.stopPropagation()}
        data-testid="video-portal"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Live View - {studentName}</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="text-white hover:bg-white/10"
            data-testid="button-close-portal"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div ref={videoContainerRef} className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 h-full w-full object-contain transition-transform duration-200"
            style={{ transform: `scale(${zoom})` }}
            data-testid="portal-video"
          />
          {zoom !== 1 ? (
            <div className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-sm text-white">
              {Math.round(zoom * 100)}%
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setZoom((current) => Math.max(current - 0.25, 0.5))}
              disabled={zoom <= 0.5}
              className="text-white hover:bg-white/10"
              data-testid="button-zoom-out"
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setZoom(1)}
              disabled={zoom === 1}
              className="text-white hover:bg-white/10"
              data-testid="button-zoom-reset"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setZoom((current) => Math.min(current + 0.25, 3))}
              disabled={zoom >= 3}
              className="text-white hover:bg-white/10"
              data-testid="button-zoom-in"
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>

          <Button variant="ghost" size="sm" onClick={handleScreenshot} className="text-white hover:bg-white/10" data-testid="button-screenshot">
            <Camera className="mr-2 h-4 w-4" />Screenshot
          </Button>
          <Button variant="ghost" size="sm" onClick={handleFullscreen} className="text-white hover:bg-white/10" data-testid="button-fullscreen">
            <Maximize className="mr-2 h-4 w-4" />Fullscreen
          </Button>
          <Button variant="ghost" size="sm" onClick={handlePictureInPicture} className="text-white hover:bg-white/10" data-testid="button-pip">
            <Minimize className="mr-2 h-4 w-4" />PiP
          </Button>
          <Button variant="default" size="sm" onClick={onClose} data-testid="button-back-to-grid">
            Back to Grid
          </Button>
          {onStopLiveView ? (
            <Button variant="destructive" size="sm" onClick={handleStopLiveView} data-testid="button-stop-live-view">
              <X className="mr-2 h-4 w-4" />Stop Live View
            </Button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default VideoPortal;
