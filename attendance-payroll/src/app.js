'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { authenticate, passwordGate } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/error');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false, // helmet's default adds upgrade-insecure-requests, which breaks plain-HTTP LAN deployments
      directives: {
        'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"], 'font-src': ["'self'"], 'object-src': ["'none'"],
        'worker-src': ["'self'"], 'manifest-src': ["'self'"], 'base-uri': ["'self'"], 'form-action': ["'self'"], 'frame-ancestors': ["'none'"],
      },
    },
  }));

  // ZKTeco ADMS endpoints: plain-text bodies, no cookies, must come before the JSON parser.
  const adms = require('./routes/adms');
  app.use('/iclock', adms);
  app.use('/api/adms', adms);

  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  app.use('/api', require('./routes/meta'));
  app.use('/api/auth', require('./routes/auth'));

  // Everything below requires a signed-in user (and a changed first-login password).
  app.use('/api', authenticate, passwordGate);
  app.use('/api/users', require('./routes/users'));
  app.use('/api/org', require('./routes/org'));
  app.use('/api/attendance', require('./routes/attendance'));
  app.use('/api/leave', require('./routes/leave'));
  app.use('/api/payroll', require('./routes/payroll'));
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api/dashboard', require('./routes/dashboard'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/devices', require('./routes/devices'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api', notFoundHandler);

  // Static PWA + the single vendored library (Chart.js) served from node_modules.
  const pub = path.join(__dirname, '..', 'public');
  app.get('/vendor/chart.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=604800');
    res.sendFile(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  });
  app.use(express.static(pub, {
    index: false, maxAge: '1h',
    setHeaders: (res, file) => { if (/(sw\.js|index\.html|manifest\.webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache'); },
  }));
  app.get(/^\/(?!api\/|iclock\/|vendor\/).*/, (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'index.html')); });

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
