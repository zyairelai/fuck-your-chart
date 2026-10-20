import "./globals.css";

export const metadata = {
  title: "fuck-your-chart",
  description: "Three live BTCUSDT futures charts. That's it.",
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