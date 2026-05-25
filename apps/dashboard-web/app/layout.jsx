import "./globals.css";

export const metadata = {
  title: "LoanConnect AI",
  description: "AI voice calling for lending"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
