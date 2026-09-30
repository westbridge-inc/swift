// Inline on purpose: the offline HTML must recover even when no JS chunk was
// cached. A normal, connected customer page never runs this handler.
export const OFFLINE_RECONNECT = "window.addEventListener('online',function(){window.location.reload();},{once:true});";
