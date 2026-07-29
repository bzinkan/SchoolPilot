import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  getPublicPageMetadata,
  normalizePathname,
  SITE_ORIGIN,
} from './routeMetadata';

const DEFAULT_TITLE = 'Schoolpilot';

function getOrCreateMeta(name) {
  let element = document.head.querySelector(`meta[name="${name}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute('name', name);
    document.head.appendChild(element);
  }
  return element;
}

function getOrCreateCanonical() {
  let element = document.head.querySelector('link[rel="canonical"]');
  if (!element) {
    element = document.createElement('link');
    element.setAttribute('rel', 'canonical');
    document.head.appendChild(element);
  }
  return element;
}

export default function SeoMetadata() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    const normalizedPath = normalizePathname(pathname);
    const metadata = getPublicPageMetadata(normalizedPath);
    const canonical = document.head.querySelector('link[rel="canonical"]');
    const description = document.head.querySelector('meta[name="description"]');

    if (!metadata) {
      document.title = DEFAULT_TITLE;
      canonical?.remove();
      description?.remove();
      getOrCreateMeta('robots').setAttribute('content', 'noindex, nofollow');
      return;
    }

    document.title = metadata.title;
    getOrCreateMeta('description').setAttribute(
      'content',
      metadata.description
    );
    getOrCreateMeta('robots').setAttribute('content', 'index, follow');
    getOrCreateCanonical().setAttribute(
      'href',
      new URL(normalizedPath, SITE_ORIGIN).href
    );
  }, [pathname]);

  return null;
}
