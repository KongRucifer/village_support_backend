module.exports = {
  apps: [
    {
      name: 'village-support-backend',
      script: 'node',
      args: 'dist/src/main.js',
      cwd: 'C:\\Users\\advice\\Desktop\\LTSventure\\webdevelop\\account_system\\app_mangage_test\\village_support_app_backend',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    }
  ]
};
