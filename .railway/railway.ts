import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const agentBridgeVolume = volume("agent-bridge-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 5000 });
  const agentBridge = service("agent-bridge", {
    replicas: { "asia-southeast1-eqsg3a": 1 },
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    deploy: { sleepApplication: false, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    volumeMounts: { "/data": agentBridgeVolume },
    env: { ADMIN_TOKEN: preserve(), DATA_DIR: preserve(), RAILWAY_RUN_UID: preserve() },
  });

  return project("agent-bridge", {
    resources: [agentBridge, agentBridgeVolume],
  });
});
