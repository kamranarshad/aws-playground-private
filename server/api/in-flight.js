// Functions currently mid-invoke. Shared between invoke (which holds a
// function's id for the duration of the call) and delete (which refuses to
// remove a function out from under an invoke in progress).
module.exports = new Set();
