import type { Child } from "@takazudo/zfb/zudo-react";

import "../styles/global.css";

type Props = {
  title?: string;
  children: Child;
};

export default function DefaultLayout({ title = "zfb JSON API starter", children }: Props) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body>
        <div class="site-shell">
          <header class="site-header">
            <div class="header-inner">
              <a class="site-title" href="/">
                JSON API starter
              </a>
              <nav class="site-nav" aria-label="API endpoints">
                <a href="/api/items">Items</a>
                <a href="/api/search">Search</a>
              </nav>
            </div>
          </header>
          <main class="site-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
