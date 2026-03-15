module.exports = {
  apps: [
    {
      name: 'minting-digitaldimension-nft-api',
      cwd: '/www/wwwroot/minting.digitaldimension.com.mx/server',
      script: 'server.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        ALLOWED_ORIGINS: 'https://minting.digitaldimension.com.mx',
      },
    },
  ],
}
