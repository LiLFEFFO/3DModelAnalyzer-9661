# Setup Analytics

We are using [Runable Analytics](https://onedollarstats.com) for privacy-friendly website analytics.

## Script Installation
1. The analytics script is already added to `index.html`:

```html
<script defer src="/runable.js" data-url="https://collector.onedollarstats.com/events"></script>
```

The script automatically tracks page views on load and SPA navigation.

## Configuration Attributes

| Attribute | Description |
|-----------|-------------|
| `data-url` | Analytics collector endpoint URL |
| `data-debug` | Set to a hostname to enable tracking on localhost (e.g., `data-debug="mysite.com"`) |
| `data-autocollect` | Set to `"false"` to disable automatic page view tracking |
| `data-hash-routing` | Add this attribute if your app uses hash-based routing |
| `data-props` | Default properties sent with all events (format: `key=value;key2=value2`) |

## Automatic Tracking

The script automatically:
- Tracks page views on initial load
- Tracks SPA navigation via `history.pushState` and `popstate` events
- Captures UTM parameters from URLs (`utm_source`, `utm_medium`, `utm_campaign`, etc.)
- Skips tracking on localhost (unless `data-debug` is set)
- Skips tracking for headless browsers and bots

## Manual Page View Tracking
2. Use `window.stonks.view()` to manually track a page view:

```typescript
// Track current page
window.stonks.view()

// Track with custom path
window.stonks.view("/custom-path")

// Track with custom properties
window.stonks.view({ myProp: "value" })

// Track with path and properties
window.stonks.view("/custom-path", { myProp: "value" })
```

## Custom Event Tracking
3. Use `window.stonks.event()` to track custom events:

```typescript
// Track a simple event
window.stonks.event("button_click")

// Track event with custom path
window.stonks.event("signup", "/signup-page")

// Track event with properties
window.stonks.event("purchase", { product: "pro_plan", amount: 99 })

// Track event with path and properties
window.stonks.event("download", "/docs", { file: "guide.pdf" })
```

## TypeScript Support
4. Add type declarations for the analytics API in `src/web/types/analytics.d.ts`:

```typescript
interface StonksAnalytics {
  event: (name: string, pathOrProps?: string | Record<string, unknown>, props?: Record<string, unknown>) => void
  view: (pathOrProps?: string | Record<string, unknown>, props?: Record<string, unknown>) => void
}

declare global {
  interface Window {
    stonks: StonksAnalytics
  }
}

export {}
```

## HTML Data Attributes
5. Track events declaratively using data attributes on elements:

```html
<!-- Track click event -->
<button data-s:event="signup_click">Sign Up</button>

<!-- Track with properties -->
<button data-s:event="download" data-s:event-props="file=guide.pdf;type=pdf">Download</button>

<!-- Track with custom path -->
<button data-s:event="cta_click" data-s:event-path="/landing">Get Started</button>
```

## Page-Level Properties
6. Set properties that apply to the current page view:

```html
<!-- In body tag -->
<body data-s:path="/custom-page-path">

<!-- Or using meta tag -->
<meta name="stonks-path" content="/custom-page-path" />

<!-- Add view properties -->
<div data-s:view-props="section=pricing;variant=a"></div>
```

## Disable Tracking
7. Disable tracking for specific pages:

```html
<!-- Using meta tag -->
<meta name="stonks-collect" content="false" />

<!-- Or using body attribute -->
<body data-s:collect="false">
```

## React Integration Example
8. Create a hook for analytics in `src/web/hooks/use-analytics.ts`:

```typescript
export const useAnalytics = () => ({
  trackEvent: (name: string, props?: Record<string, unknown>) => {
    window.stonks?.event(name, props)
  },
  trackView: (path?: string, props?: Record<string, unknown>) => {
    window.stonks?.view(path, props)
  }
})
```

Usage in components:

```tsx
import { useAnalytics } from "../hooks/use-analytics"

function PricingPage() {
  const { trackEvent } = useAnalytics()

  const handlePlanSelect = (plan: string) => {
    trackEvent("plan_selected", { plan })
  }

  return (
    <button onClick={() => handlePlanSelect("pro")}>
      Select Pro
    </button>
  )
}
```
