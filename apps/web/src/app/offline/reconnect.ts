// Inline on purpose: the offline HTML must recover even when no JS chunk was
// cached. A normal, connected customer page never runs this handler.
export const OFFLINE_RECONNECT = "document.getElementById('offline-retry').addEventListener('click',function(){window.location.reload();});window.addEventListener('online',function(){window.location.reload();},{once:true});";
