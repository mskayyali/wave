# NVIDIA speech runtime

Wave runs Parakeet locally using NVIDIA's NeMo-Speech.cpp 0.3.0 Metal runtime.
Run `bun run setup:parakeet` before building a fresh checkout on Apple Silicon.
The generated `runtime/` directory is bundled at `Resources/nemo-speech/`;
users do not need Python, Homebrew, or a separate installation.

The setup script downloads the official macOS arm64 archive, verifies NVIDIA's
published SHA-256, and retains its licence and third-party notices under
`runtime/share/licenses/`. NVIDIA-authored runtime code is Apache-2.0;
components retain their respective licences. Model weights are downloaded
separately from NVIDIA's pinned Parakeet repository (CC BY 4.0).

Upstream: https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.3.0
