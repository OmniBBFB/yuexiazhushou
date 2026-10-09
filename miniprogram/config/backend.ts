export interface BackendConfig {
  mode: 'cloud' | 'local'
  local: { baseUrl: string; accessKey: string; clientId: string }
}

// Change mode to 'local' and recompile to run the isolated local experiment.
// Cloud remains the default. Local identities and data never enter the cloud API.
export const backendConfig: BackendConfig = {
  mode: 'local',
  local: {
    baseUrl: 'http://172.16.111.11:8787',
    accessKey: 'local-development-only',
    clientId: 'developer',
  },
}
