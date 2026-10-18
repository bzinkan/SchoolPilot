import { useEffect, useMemo, useState } from 'react';
import { kioskThemeAssetPath, resolveKioskTheme } from '../../shared/themes/kiosk';

// Turns the theme the server sent with the kiosk session, config or snapshot
// into root attributes for the kiosk page. Preset artwork is a static file;
// an uploaded background is fetched through the kiosk client, so it carries
// the kiosk token and session headers, and painted from an object URL. When
// the image cannot be loaded the page keeps the flat theme color.
export function useKioskTheme(theme, kioskClient) {
  const kind = theme?.kind ?? null;
  const preset = kind === 'preset' ? theme.preset : null;
  const assetId = kind === 'image' ? theme.imageAssetId : null;
  const fit = kind === 'image' ? theme.fit : null;
  const active = useMemo(() => resolveKioskTheme(kind === 'preset' ? { kind, preset } : kind === 'image' ? { kind, imageAssetId: assetId, fit } : null),
    [kind, preset, assetId, fit]);
  const [image, setImage] = useState(null); // { assetId, url | null }
  const wantedAsset = active?.imageAssetId ?? null;

  useEffect(() => {
    if (!wantedAsset || !kioskClient) return undefined;
    const controller = new AbortController();
    let objectUrl = null;
    (async () => {
      try {
        const response = await kioskClient.request(kioskThemeAssetPath(wantedAsset), { method: 'GET', signal: controller.signal, headers: { Accept: 'image/*' } });
        if (!response.ok) throw new Error(`theme asset ${response.status}`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ assetId: wantedAsset, url: objectUrl });
      } catch {
        if (!controller.signal.aborted) setImage({ assetId: wantedAsset, url: null });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [wantedAsset, kioskClient]);

  const artwork = !active ? null : active.imageAssetId ? (image?.assetId === active.imageAssetId ? image.url : null) : active.artwork;
  const rootProps = active
    ? { 'data-kiosk-theme': active.id, 'data-kiosk-image-fit': active.imageAssetId ? active.fit : undefined, style: artwork ? { '--kiosk-image': `url("${artwork}")` } : undefined }
    : {};
  return { active, artwork, rootProps };
}
