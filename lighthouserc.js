/** @type {import('@lhci/cli').LighthouseRcConfig} */
module.exports = {
  ci: {
    collect: {
      startServerCommand: "npm run start",
      startServerReadyPattern: "ready on",
      url: ["http://localhost:3000"],
      numberOfRuns: 3,
      settings: {
        chromeFlags: "--no-sandbox",
      },
    },
    assert: {
      // `budgets` is not a real LHCI assert key — resourceSizes/resourceCounts
      // limits from the old budget.json are asserted directly below instead,
      // via the `resource-summary:*` audits (sizes in bytes, counts unitless).
      assertions: {
        "categories:performance": ["error", { minScore: 0.7 }],
        "categories:accessibility": ["error", { minScore: 0.85 }],
        "categories:best-practices": ["error", { minScore: 0.8 }],
        "categories:seo": ["error", { minScore: 0.85 }],
        "first-contentful-paint": ["warn", { maxNumericValue: 2500 }],
        "largest-contentful-paint": ["error", { maxNumericValue: 4000 }],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.15 }],
        "total-blocking-time": ["warn", { maxNumericValue: 500 }],
        "interactive": ["warn", { maxNumericValue: 5000 }],
        "max-potential-fid": ["warn", { maxNumericValue: 200 }],
        "bootup-time": ["warn", { maxNumericValue: 2000 }],
        "mainthread-work-breakdown": ["warn", { maxNumericValue: 4000 }],
        "resource-summary:document:size": ["error", { maxNumericValue: 50 * 1024 }],
        "resource-summary:script:size": ["error", { maxNumericValue: 500 * 1024 }],
        "resource-summary:stylesheet:size": ["error", { maxNumericValue: 100 * 1024 }],
        "resource-summary:image:size": ["error", { maxNumericValue: 200 * 1024 }],
        "resource-summary:total:size": ["error", { maxNumericValue: 1200 * 1024 }],
        "resource-summary:script:count": ["error", { maxNumericValue: 20 }],
        "resource-summary:third-party:count": ["error", { maxNumericValue: 15 }],
      },
    },
    upload: {
      target: "temporary-public-storage",
    },
  },
};
