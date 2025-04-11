{ pkgs }:
pkgs.mkShell {
  # Add build dependencies
  packages = [
    pkgs.nodePackages_latest.nodejs
    pkgs.nodePackages_latest.pnpm
    pkgs.nodePackages_latest.typescript

    # TS language server that implements the VS Code extension host rather than
    # building a wrapper around the tsserver logic.
    pkgs.vtsls
    pkgs.tailwindcss-language-server

    # Deno includes an excellent formatter that I want to use instead of Prettier.
    pkgs.deno
  ];

  # Add environment variables
  env = { };

  # Load custom bash code
  shellHook = ''

  '';
}
