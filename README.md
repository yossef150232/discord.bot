# Store Ticket Bot

A Discord bot built with Discord.js v14 for managing gaming account sales, customer tickets, warranty tracking, seller ranks, and reporting.

---

## Features

- **Interactive Ticket Panel**: Selectable game catalog, customizable account types, quantity pickers, and payment methods.
- **Account Submission**: Modal forms for sellers to submit login credentials and account recovery details.
- **Warranty & Funds Timer**: Automated countdown for warranties with scheduled funds release and channel cleanup.
- **Seller Rank System**: Automatic role assignment based on delivered account milestones.
- **Buyer DM Interface**: Private retrieval of purchased account credentials and financial balance inquiries.
- **Google Sheets Mirror**: Optional, non-blocking webhook integration for logging tickets, sales, payouts, and account credentials.
- **Lightweight Storage**: Atomic file-backed JSON storage with journal recovery and zero database dependencies.

---

## Project Structure

```text
├── data/                    # JSON data storage
│   ├── accounts-data.json   # Submitted account credentials
│   ├── audit-log.json       # Audit log entries
│   ├── games.json           # Configured games and stock
│   ├── sellers.json         # Seller statistics and ranks
│   ├── ticket-config.json   # Panel message references
│   └── tickets.json         # Active and archived tickets
├── .env                     # Local environment variables
├── .env.example             # Example configuration template
├── appsscript.gs            # Google Apps Script endpoint code
├── index.js                 # Bot entry point and event handlers
├── infinity-bot.service     # Linux systemd service unit file
├── package.json             # Node.js dependencies and scripts
└── sheets.js                # Google Sheets logging module
```

---

## Prerequisites

- Node.js 18.0.0 or higher
- A Discord Bot token with Server Members and Message Content Privileged Intents enabled

---

## Installation

1. Install project dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your Discord credentials and server IDs.

---

## Environment Variables

| Variable | Description | Required |
| :--- | :--- | :--- |
| `TOKEN` | Discord Bot Token | Yes |
| `CLIENT_ID` | Discord Application Client ID | Yes |
| `GUILD_ID` | Target Discord Server ID | Yes |
| `TICKET_CATEGORY_ID` | Category ID where ticket channels are created | Yes |
| `STAFF_ROLE_ID` | Role ID for store staff | Yes |
| `ADMIN_ROLE_ID` | Role ID for administrators (defaults to STAFF_ROLE_ID) | No |
| `RANK_ROLE_*` | Role IDs for seller ranks (Trusted, Legendary, Gold, Epic, Silver) | No |
| `SHEETS_WEBHOOK_URL` | Google Apps Script Web App URL | No |
| `SHEETS_SECRET` | Secret token verified by the Google Apps Script Web App | No |
| `DATA_DIR` | Custom path for JSON storage (defaults to `./data`) | No |

---

## Running the Bot

### Direct Execution
```bash
npm start
```

### Production Deployment (systemd on Linux)

1. Copy the service unit file to the systemd directory:
   ```bash
   sudo cp infinity-bot.service /etc/systemd/system/infinity-bot.service
   ```

2. Reload the systemd daemon:
   ```bash
   sudo systemctl daemon-reload
   ```

3. Enable on boot and start the service:
   ```bash
   sudo systemctl enable --now infinity-bot
   ```

4. Check service status:
   ```bash
   sudo systemctl status infinity-bot
   ```

5. View live logs:
   ```bash
   sudo journalctl -u infinity-bot -f -n 100
   ```

---

## Administrative Slash Commands

- `/setup-ticket`: Spawns the permanent ticket creation panel in the current channel.
- `/add-game`: Adds a new game to the store catalog.
- `/set-stock`: Updates available account stock for a game.
- `/set-price`: Sets or updates the fixed price for a game.
- `/set-warranty`: Sets custom warranty duration (in days) for a game.
- `/set-rank`: Manually sets or overrides a seller's rank.
- `/confirm-buyer-payment`: Confirms buyer payment collection for an order.
