import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "리듬게임 BGM 분석",
  description: "리듬게임용 BGM의 BPM, offset, song length와 이벤트 후보를 검토하는 웹 도구",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
