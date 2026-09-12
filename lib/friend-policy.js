'use strict';

const MAX_FRIENDS = 500;
const MAX_REQUESTS = 200;

function friendAction(me, target) {
  if (!target) return { action: 'reject', reason: 'not_found' };
  if (target.id === me.id) return { action: 'reject', reason: 'self' };
  if (target.blockedUsers.includes(me.id)) return { action: 'reject', reason: 'not_found' };
  if (me.blockedUsers.includes(target.id)) return { action: 'reject', reason: 'blocked' };
  if (me.friends.includes(target.id) && target.friends.includes(me.id)) return { action: 'friends' };
  if (!me.friends.includes(target.id) && me.friends.length >= MAX_FRIENDS) {
    return { action: 'reject', reason: 'limit_reached' };
  }
  if (!target.friends.includes(me.id) && target.friends.length >= MAX_FRIENDS) {
    return { action: 'reject', reason: 'target_limit_reached' };
  }
  if (me.friendRequests.includes(target.id)) return { action: 'accept' };
  if (target.friendRequests.includes(me.id)) return { action: 'pending' };
  if (target.friendRequests.length >= MAX_REQUESTS) {
    return { action: 'reject', reason: 'target_limit_reached' };
  }
  return { action: 'request' };
}

module.exports = { friendAction };
