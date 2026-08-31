// Cross-component bridge for HermesBridgeToggle and similar consumers
// that need to read the latest projects list without prop-drilling.

declare global {
  interface Window {
    __dashboardProjects?: any[]
  }
}

export {}
