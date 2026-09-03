# Pi evolving Web UI

This is the mutable workspace owned by the containerized Pi Agent. The fixed
control plane serves `web/` and bridges its HTTP API to Pi's RPC mode.

Run the immutable smoke test from inside the container:

```sh
node /opt/pi-control/acceptance.mjs http://127.0.0.1:3000
```

The workspace persists at `/Users/slhmy/data/pi-agent/workspace` on the host.
