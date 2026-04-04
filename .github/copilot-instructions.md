# AI Coding Agent Instructions for GuildWars

Welcome to the GuildWars codebase! This document provides essential guidance for AI coding agents to be productive in this project. The GuildWars project is a tabletop roleplaying game with a Unity-based digital component. Below are the key aspects of the codebase and workflows.

## Project Overview
- **GuildWars** is a tabletop roleplaying game where players manage unique guilds in a bustling city. The Unity-based digital component supports gameplay with tools for character management, animations, and visual scripting.
- The Unity project is located in `GW2-Unity/GW2/`.
- The game leverages Unity's 2D animation tools, visual scripting, and other Unity packages.

## Codebase Structure
- **Unity Project**: The Unity project resides in `GW2-Unity/GW2/`.
  - `Assets/`: Contains game assets, including scenes and prefabs.
  - `Library/`: Unity's internal cache (do not modify).
  - `ProjectSettings/`: Unity project configuration.
  - `Packages/`: External Unity packages.
- **Game Rules**: The tabletop rules are documented in `Game Rules/`.
  - `Rules.md`: Markdown version of the rules.
  - `Rules.html`: HTML version of the rules.

## Key Workflows
### Building the Unity Project
1. Open the Unity Editor.
2. Load the project from `GW2-Unity/GW2/`.
3. Use `File > Build Settings` to configure and build the project.

### Testing
- Unity Test Framework is used for testing. Tests are located in `Assets/Tests/`.
- Run tests via the Unity Test Runner (`Window > General > Test Runner`).

### Debugging
- Use Unity's built-in debugger or attach an external debugger (e.g., Visual Studio).
- Logs are stored in `GW2-Unity/GW2/Logs/`.

## Project-Specific Conventions
- **Visual Scripting**: Use Unity's Visual Scripting (formerly Bolt) for designing game logic. Graphs are stored in `Assets/VisualScripting/`.
- **2D Animation**: Utilize Unity's 2D Animation package for character animations. Skinning and rigging are managed via the Sprite Editor.
- **File Organization**: Follow Unity's standard folder structure for assets and scripts.

## External Dependencies
- Unity packages (e.g., `com.unity.2d.animation`, `com.unity.visualscripting`) are managed via the Unity Package Manager.
- Ensure all required packages are installed before building or running the project.

## Tips for AI Agents
- **Understand Unity-Specific Patterns**: Familiarize yourself with Unity's MonoBehaviour lifecycle and event-driven architecture.
- **Follow Existing Patterns**: Review existing scripts in `Assets/Scripts/` to understand the project's coding style.
- **Leverage Documentation**: Refer to Unity's official documentation for package-specific details (e.g., [Visual Scripting](https://docs.unity3d.com/bolt/1.4/manual/index.html)).

## Key Files and Directories
- `GW2-Unity/GW2/Assets/`: Game assets and scripts.
- `GW2-Unity/GW2/Logs/`: Debug logs.
- `Game Rules/Rules.md`: Tabletop rules.

For further questions or clarifications, consult the project maintainers or refer to the Unity documentation.