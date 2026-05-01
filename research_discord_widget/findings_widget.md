# Findings: Discord Server Widget settings

- Discord's official developer docs still expose guild widget fields: `widget_enabled` and `widget_channel_id` on the guild object, plus a Guild Widget Settings object with `enabled` and `channel_id`.
  Source: https://docs.discord.com/developers/resources/guild
- Official API docs say `Get Guild Widget Settings` and `Modify Guild Widget` require `MANAGE_GUILD`; public `Get Guild Widget` and `Get Guild Widget Image` exist, but only work when the widget is enabled.
  Source: https://docs.discord.com/developers/resources/guild
- Shields.io says its Discord badge requires the Discord JSON API and a server admin must enable the server widget setting.
  Source: https://shields.io/badges/discord
- A recent Reddit report about the missing Widget tab says the widget setting is now located under `Engagement` in Server Settings.
  Source: https://www.reddit.com/r/discordapp/comments/1jpvk66/no_discord_widget_tab_no_idea_how_to_activateget/
- Direct check for Helmor server widget endpoint returned `403` with `{"message":"Widget Disabled","code":50004}`, confirming the badge state is currently disabled.
  Checked URL: https://discord.com/api/guilds/1499667625267957920/widget.json
