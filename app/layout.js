import "./globals.css";

export const metadata = {
  title: "BTC Collector",
  description: "Private BTCUSDT market collection dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
