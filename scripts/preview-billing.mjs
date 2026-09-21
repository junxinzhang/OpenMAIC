process.loadEnvFile('.env.cowork-test');
process.argv=[process.argv[0],'next','dev','--port','3216','--hostname','127.0.0.1'];
await import('next/dist/bin/next');
