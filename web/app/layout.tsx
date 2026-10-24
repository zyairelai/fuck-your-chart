import "./globals.css";

export const metadata = {
  title: "BTC fuck-your-chart",
  description: "Live BTCUSDT futures charts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">{children}</div>
      </body>
    </html>
  );
}