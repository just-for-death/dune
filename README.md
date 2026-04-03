# Dune 🏜️

**Dune** is a standalone Desktop application built with Electron, React, and Vite. It serves as the primary desktop client for managing and storing your PC game saves, connecting seamlessly to the broader Dune ecosystem.

## Features
- **Cross-Platform:** Built with Electron to ensure compatibility across major operating systems.
- **Modern UI:** Uses React and Vite for a fast, responsive, and beautiful user interface.
- **Automatic Save Sync:** Manages game save directories by securely packaging (`adm-zip`) them and syncing directly with your local Dune Server instance.
- **Local Settings Management:** Easily manage your paths and server connections using `electron-store`.

## Installation

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Start Development Server:**
   ```bash
   npm run dev
   ```

3. **Build the Application:**
   ```bash
   npm run build
   ```

## Tech Stack
- React 18
- Vite
- Electron
- TypeScript
