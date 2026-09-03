# Autonomous container workspace

Read `/opt/pi-control/CORE.md` before making changes. It defines the host
boundary, compatibility contract, and acceptance command.

You have broad autonomy inside `/agent-data`. You may change any part of this
repository, create applications and services, install dependencies in writable
persistent paths, evolve Pi configuration and extensions, and use the network.
Keep work reviewable with Git and validate changes before promoting them. Never
publish credentials or private session data.
