import type { ReactNode } from 'react';
import { t } from '../i18n/index.ts';

// Filled icons for the sections. They take the color of the text, and the navbar gives them their size.
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      {children}
    </svg>
  );
}

export function CatalogIcon() {
  return (
    <Icon>
      <g transform="rotate(-9 3 9)">
        <path
          fillRule="evenodd"
          d="M4 3.5h16a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1zM7.4 4.9h2.4L8.4 7.6H6zM12 4.9h2.4L13 7.6h-2.4zM16.6 4.9H19l-1.4 2.7h-2.4z"
        />
      </g>
      <path fillRule="evenodd" d="M3 10.5h18V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10 13.3v5.4l4.6-2.7z" />
    </Icon>
  );
}

export function CalendarIcon() {
  return (
    <Icon>
      <rect x="7" y="2.5" width="2" height="5" rx="1" />
      <rect x="15" y="2.5" width="2" height="5" rx="1" />
      <path
        fillRule="evenodd"
        d="M6 4.5h12a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-11a3 3 0 0 1 3-3zM6.5 11.5v3h3v-3zM10.5 11.5v3h3v-3zM14.5 11.5v3h3v-3zM6.5 16v3h3v-3zM10.5 16v3h3v-3z"
      />
    </Icon>
  );
}

// The Alerts section shows only this icon, so the icon carries the name of its link.
export function AlertsIcon() {
  return (
    <svg role="img" aria-label={t('Alerts')} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1z" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <Icon>
      <path
        fillRule="evenodd"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        d="M10.01 4.56L10.39 1.83L13.61 1.83L13.99 4.56A7.7 7.7 0 0 1 15.85 5.33L18.05 3.67L20.33 5.95L18.67 8.15A7.7 7.7 0 0 1 19.44 10.01L22.17 10.39L22.17 13.61L19.44 13.99A7.7 7.7 0 0 1 18.67 15.85L20.33 18.05L18.05 20.33L15.85 18.67A7.7 7.7 0 0 1 13.99 19.44L13.61 22.17L10.39 22.17L10.01 19.44A7.7 7.7 0 0 1 8.15 18.67L5.95 20.33L3.67 18.05L5.33 15.85A7.7 7.7 0 0 1 4.56 13.99L1.83 13.61L1.83 10.39L4.56 10.01A7.7 7.7 0 0 1 5.33 8.15L3.67 5.95L5.95 3.67L8.15 5.33A7.7 7.7 0 0 1 10.01 4.56ZM8.2 12a3.8 3.8 0 1 0 7.6 0a3.8 3.8 0 1 0-7.6 0z"
      />
    </Icon>
  );
}
