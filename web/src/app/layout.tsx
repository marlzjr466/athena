import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Athena — Intelligence with a little personality.',
  description: 'Meet Athena, your personal AI desktop companion. Explore her real-time 3D world, local AI, voice, coding tools, and a personality that feels like yours.',
  icons: { icon: '/assets/athena.svg' },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
