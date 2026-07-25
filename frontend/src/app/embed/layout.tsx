// The embed route renders a minimal, iframe-friendly widget and must not
// inherit the app's root <html>/<body> chrome (theme script, gradient
// background, Providers). This layout opts the /embed/* subtree out of the
// nesting Next.js would otherwise apply from app/layout.tsx.
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
