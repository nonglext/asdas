'use strict';
// Pure decision policy. Transactions and notifications belong to the server.
function friendAction(me, target, { maxFriends = 500, maxRequests = 200 } = {}) {
  const deny = reason => ({ action: 'reject', reason });
  if (!target) return deny('not_found');
  if (me.id === target.id) return deny('self');
  if (target.blockedUsers.includes(me.id)) return deny('not_found');
  if (me.blockedUsers.includes(target.id)) return deny('blocked');
  if (me.friends.includes(target.id) && target.friends.includes(me.id)) return { action: 'friends' };
  if (me.friends.length >= maxFriends || target.friends.length >= maxFriends) return deny('limit_reached');
  if (me.friendRequests.includes(target.id)) return { action: 'accept' };
  if (target.friendRequests.includes(me.id)) return { action: 'pending' };
  if (target.friendRequests.length >= maxRequests) return deny('target_limit_reached');
  return { action: 'request' };
}
module.exports = { friendAction };
