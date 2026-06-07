// Express fixture — minimal app, 3 routes + middleware chain.
// Read by `Framework extractors` test suite.
const express = require('express');
const app = express();

// Middleware
app.use(express.json());
app.use((req, res, next) => next());

app.get('/users', listUsers);
app.post('/users', createUser);
app.put('/users/:id', updateUser);

function listUsers(req, res) { res.json([]); }
function createUser(req, res) { res.json({}); }
function updateUser(req, res) { res.json({}); }

module.exports = app;
