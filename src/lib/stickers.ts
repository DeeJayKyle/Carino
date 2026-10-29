import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccessoryArt, type Accessory } from '../components/Avatar';
import { shareFile } from '../../mobile/native';

/** Where each accessory sits on the sticker (units of the 160×170 sticker canvas). */
const PLACE: Record<Exclude<Accessory, 'none'>, { x: number; y: number; w: number; rotate: number }> = {
  crown: { x: 45, y: 18, w: 70, rotate: -6 },
  chef: { x: 38, y: -2, w: 84, rotate: 4 },
  cap: { x: 34, y: 22, w: 92, rotate: -4 },
  headband: { x: 30, y: 52, w: 100, rotate: 0 },
  party: { x: 66, y: -2, w: 42, rotate: 12 },
};

/** Carino as a standalone SVG, with a white sticker outline. */
export function stickerSvg(accessory: Accessory) {
  const acc = accessory !== 'none' ? PLACE[accessory] : null;
  const art = acc ? renderToStaticMarkup(createElement(AccessoryArt, { kind: accessory })).replace('<svg', `<svg x="${acc.x}" y="${acc.y}" width="${acc.w}" transform="rotate(${acc.rotate} ${acc.x + acc.w / 2} ${acc.y + acc.w / 3})"`) : '';
  const body = 'M60 26 C88 26 106 44 106 70 C106 94 86 110 60 110 C34 110 14 94 14 70 C14 44 32 26 60 26 Z';
  const sprout = acc ? '' : `<g transform="translate(20 40)"><path d="M60 30 C60 22 60 16 61 10" stroke="#3f8f5a" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M61 14 C66 4 80 4 84 9 C78 16 68 18 61 14 Z" fill="#5fbf7a" stroke="#3f8f5a" stroke-width="2.5"/><path d="M60 18 C55 10 44 10 41 14 C46 20 54 21 60 18 Z" fill="#7fd394" stroke="#3f8f5a" stroke-width="2.5"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 170" width="512" height="544">
<defs><radialGradient id="s" cx="38%" cy="30%" r="75%"><stop offset="0%" stop-color="#ffd9c8"/><stop offset="35%" stop-color="#ff9b7c"/><stop offset="80%" stop-color="#ec6446"/><stop offset="100%" stop-color="#c4462f"/></radialGradient></defs>
<g transform="translate(20 40)"><path d="${body}" fill="#fff" stroke="#fff" stroke-width="14" stroke-linejoin="round"/></g>
${sprout}
<g transform="translate(20 40)">
<path d="${body}" fill="url(#s)"/>
<ellipse cx="42" cy="44" rx="11" ry="6" fill="#fff" opacity="0.35" transform="rotate(-24 42 44)"/>
<ellipse cx="34" cy="80" rx="8" ry="5" fill="#ff6f8a" opacity="0.45"/><ellipse cx="86" cy="80" rx="8" ry="5" fill="#ff6f8a" opacity="0.45"/>
<ellipse cx="48" cy="62" rx="5" ry="7" fill="#2a1a24"/><ellipse cx="72" cy="62" rx="5" ry="7" fill="#2a1a24"/>
<circle cx="49.5" cy="59.5" r="1.6" fill="#fff"/><circle cx="73.5" cy="59.5" r="1.6" fill="#fff"/>
<path d="M51 74 Q60 82 69 74" fill="none" stroke="#2a1a24" stroke-width="3" stroke-linecap="round"/>
</g>
${art}
</svg>`;
}

async function stickerPng(accessory: Accessory): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([stickerSvg(accessory)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, (512 - 481) / 2, 0, 481, 512); // keep the 160×170 shape inside a square sticker
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw the sticker'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Opens the phone's share sheet with a sticker of Carino (wearing what it wears now). */
export async function shareSticker(accessory: Accessory, name: string) {
  const png = await stickerPng(accessory);
  return shareFile(png, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'carino'}-sticker.png`, `A sticker from ${name}`);
}
