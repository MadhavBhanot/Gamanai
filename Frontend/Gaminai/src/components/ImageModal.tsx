import { X, Download, ZoomIn, ZoomOut, Maximize, Minimize } from 'lucide-react';
import { useState, MouseEvent } from 'react';

type ImageModalProps = {
  src: string;
  alt?: string;
  onClose: () => void;
};

const ImageModal = ({ src, alt, onClose }: ImageModalProps) => {
  const [isZoomed, setIsZoomed] = useState(false);

  const handleDownload = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (alt || 'gaminai-research-image').replace(/[^a-z0-9]/gi, '-').toLowerCase();
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed', error);
      window.open(src, '_blank');
    }
  };

  const toggleZoom = (e: MouseEvent) => {
    e.stopPropagation();
    setIsZoomed(!isZoomed);
  };

  return (
    <div className="image-modal-overlay" onClick={onClose} aria-modal="true" role="dialog">
      <div className="image-modal-toolbar">
        <button className="image-modal-btn" onClick={handleDownload} title="Download Image">
          <Download size={20} />
        </button>
        <button className="image-modal-btn" onClick={toggleZoom} title={isZoomed ? "Zoom Out" : "Zoom In"}>
          {isZoomed ? <Minimize size={20} /> : <Maximize size={20} />}
        </button>
        <button className="image-modal-btn close-btn" onClick={onClose} title="Close">
          <X size={20} />
        </button>
      </div>
      
      <div className={`image-modal-content ${isZoomed ? 'is-zoomed' : ''}`} onClick={(e) => e.stopPropagation()}>
        <img 
          src={src} 
          alt={alt || 'Full size research image'} 
          className="image-modal-img"
          onClick={toggleZoom}
        />
      </div>
      
      {alt && !isZoomed && (
        <div className="image-modal-caption">
          <p>{alt}</p>
        </div>
      )}
    </div>
  );
};

export default ImageModal;
