# Vendored dependencies

`vexo-open-kit/` is copied unmodified from the team-provided
`group-vexo-open-kit` checkout so every collaborator uses the same Bluetooth
contract, Python library, simulator, and gesture-trainer reference.

- Source remote: `https://github.com/wongywrongy/group-vexo-open-kit.git`
- Imported commit: `1e4291e2fa4896b1f603d3d4f0b009c483425da0`
- License: see `vexo-open-kit/LICENSE`

Do not implement BodyOS features inside the vendored directory. Team-owned
Vexo integration belongs in `services/mac-runtime/src/bodyos_mac/`.
