/**
 * Single-owner process configuration for the in-process Baileys socket.
 * Keep the WhatsApp auth directory outside the replaceable app checkout.
 */
module.exports = {
    apps: [
        {
            name: "marketplate",
            cwd: __dirname,
            script: "node_modules/next/dist/bin/next",
            args: "start -H 127.0.0.1 -p 3002",
            exec_mode: "fork",
            instances: 1,
            autorestart: true,
            kill_timeout: 15000,
            env_production: {
                NODE_ENV: "production",
                WHATSAPP_AUTH_DIR: "/var/lib/marketplate/whatsapp-auth",
                UPLOAD_DIR: "/var/lib/marketplate/uploads",
            },
        },
    ],
};
