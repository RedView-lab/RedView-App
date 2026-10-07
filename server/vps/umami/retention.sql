-- Conservation des données d'audience : 25 mois au plus (recommandation CNIL
-- pour la mesure d'audience exemptée de consentement). Lancé chaque mois par
-- redview-umami-retention.timer ; sans effet tant que rien n'a 25 mois.
-- Tables d'Umami 3.4 qui portent des données par visite.
BEGIN;
DELETE FROM event_data WHERE created_at < now() - interval '25 months';
DELETE FROM website_event WHERE created_at < now() - interval '25 months';
DELETE FROM session_data WHERE created_at < now() - interval '25 months';
DELETE FROM heatmap_event WHERE created_at < now() - interval '25 months';
DELETE FROM session_replay WHERE created_at < now() - interval '25 months';
DELETE FROM session_link WHERE created_at < now() - interval '25 months';
DELETE FROM revenue WHERE created_at < now() - interval '25 months';
DELETE FROM session s
  WHERE s.created_at < now() - interval '25 months'
    AND NOT EXISTS (SELECT 1 FROM website_event e WHERE e.session_id = s.session_id);
COMMIT;
