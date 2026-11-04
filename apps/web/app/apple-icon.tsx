import { ImageResponse } from 'next/og';

// Home-screen icon for iPhone ("Add to Home Screen"); iOS ignores SVG icons.
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

const CLAW = (
  <>
    <path d="M20 6 C18 12, 19 18, 22 22" />
    <path d="M28 6 C30 12, 27 18, 24.5 21.5" />
  </>
);

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0f1a' }}>
        <svg width="120" height="120" viewBox="0 0 48 48" fill="none" stroke="#ff4d4d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3">
          {CLAW}
          <g transform="rotate(120, 24, 24)">{CLAW}</g>
          <g transform="rotate(240, 24, 24)">{CLAW}</g>
        </svg>
      </div>
    ),
    size,
  );
}
