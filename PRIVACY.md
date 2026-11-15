# Privacy

Claude Dashboard runs entirely on your own computer. It has no server of its own and its author receives none of your data.

## Google Calendar

Connecting a Google account is optional. When you connect one, the dashboard asks Google for three permissions:

- **See the list of your calendars**, used to show that account's calendars and their events directly from Google.
- **See, create and change events on your calendars**, used to show your events and to add, move, edit and delete them when you do so in the dashboard.
- **See when people and rooms are free or busy**, used only to show availability for the guests and rooms you pick while creating an event.

What happens with that access:

- Requests go straight from your computer to Google. Nothing passes through any other service.
- The sign-in token is stored in a file on your computer (`~/.claude-dashboard/google.json`), readable only by your user account.
- The dashboard does not read your mail, contacts or files, and does not share calendar data with anyone.
- "Disconnect" in the calendar's menu revokes the token at Google and deletes it from your computer. You can also remove access at https://myaccount.google.com/permissions.

## Calendar events on your Mac

Events are read from the Calendar app on your Mac after you allow it in macOS. The names and addresses of people and rooms on your events are kept in memory to suggest guests; they are not written to disk or sent anywhere.

## Contact

Questions: open an issue at https://github.com/ReinVanbelleghem/claude-dashboard/issues.
