<?php
/**
 * Backend dependency for the Astro frontend (see IMPLEMENTATION.md ยง2, Phase 0
 * in TASKS.md). Drop this into a small must-use plugin (wp-content/mu-plugins/)
 * or the active theme's functions.php.
 *
 * Adds `wp_template` on the REST page response — the core REST API doesn't
 * expose the assigned page template, but the frontend uses it as the "class"
 * that drives layout selection.
 *
 * CORS is NOT enabled here on purpose: the Astro app fetches WordPress
 * server-side (from the Node process), never from the visitor's browser, so
 * the browser same-origin/CORS restriction never applies to this traffic.
 * Only add CORS headers if a future feature calls the WP REST API directly
 * from client-side JS.
 *
 * Also fires a revalidation webhook on publish/update/trash (below) so the
 * frontend's in-memory cache (src/lib/wp.ts) is purged immediately instead
 * of waiting out its TTL fallback — see astro_trigger_revalidate().
 */

add_action( 'rest_api_init', function () {
	register_rest_field(
		'page',
		'wp_template',
		array(
			'get_callback' => function ( $post ) {
				return get_page_template_slug( $post['id'] );
			},
			'schema' => array(
				'type'        => 'string',
				'description' => 'Assigned page template slug, used by the frontend to select a layout.',
				'context'     => array( 'view' ),
			),
		)
	);

	/*
	 * The featured image's URL, resolved server-side. The frontend can't rely
	 * on `_embed=wp:featuredmedia` for this: an attachment's REST visibility
	 * is inherited from the post it was originally uploaded to (post_parent),
	 * not from the page using it as a featured image. An image uploaded to a
	 * page that is now draft/private/trashed 401s for anonymous requests, so
	 * WP silently drops it from _embedded (and from _links) even though a
	 * published page still uses it — the image then never renders.
	 */
	foreach ( array( 'page', 'post' ) as $post_type ) {
		register_rest_field(
			$post_type,
			'featured_image_url',
			array(
				'get_callback' => function ( $post ) {
					$thumbnail_id = get_post_thumbnail_id( $post['id'] );
					return $thumbnail_id ? ( wp_get_attachment_image_url( $thumbnail_id, 'full' ) ?: null ) : null;
				},
				'schema'       => array(
					'type'        => array( 'string', 'null' ),
					'description' => 'Full-size featured image URL, independent of the attachment\'s own REST visibility.',
					'context'     => array( 'view' ),
				),
			)
		);
	}
} );

/**
 * Lets visitors post a comment via the REST API without being logged in
 * (src/components/CommentSection.astro → src/pages/api/comments.ts →
 * submitComment() in src/lib/wp.ts). WP_REST_Comments_Controller blocks
 * this by default, independently of and in addition to the
 * "Users must be registered and logged in to comment" Discussion setting —
 * that setting only governs the classic wp-comments-post.php form, a
 * separate code path. Without this filter, create_item_permissions_check()
 * always falls through to `apply_filters( 'rest_allow_anonymous_comments', false, ... )`
 * and rejects every anonymous submission with "Sorry, you must be logged in
 * to comment.", no matter what the Discussion setting or the underlying
 * `comment_registration` option are set to.
 *
 * Per-page moderation is untouched by this: each page's own "Allow
 * comments" (Discussion panel / comment_status) still gates whether the
 * form appears/works at all, and every comment created this way still
 * lands in WordPress's normal moderation queue (or wherever
 * wp_allow_comment()'s own spam/flood/auto-approve rules put it) — this
 * filter only removes the REST-specific "must be logged in" blanket block.
 */
add_filter( 'rest_allow_anonymous_comments', '__return_true' );

/**
 * Push-based cache invalidation for the Astro frontend (see
 * src/lib/wp.ts's purgeCache() and src/pages/api/revalidate.ts). Publishing
 * a page now shows up on the live site within seconds instead of waiting
 * out PAGE_TREE_CACHE_TTL, which remains in place as a fallback in case
 * this ping ever fails to fire or fails to arrive.
 *
 * Reads the target URL and shared secret from wp-config.php constants
 * (ASTRO_REVALIDATE_URL, ASTRO_REVALIDATE_SECRET) rather than hardcoding
 * them here, and no-ops silently if they haven't been defined yet — so this
 * file is safe to drop in before wp-config.php is updated.
 */
function astro_trigger_revalidate() {
	if ( ! defined( 'ASTRO_REVALIDATE_URL' ) || ! defined( 'ASTRO_REVALIDATE_SECRET' ) ) {
		return;
	}

	// blocking (not fire-and-forget): non-blocking wp_remote_post calls are
	// unreliable on managed/shared hosting — the PHP process can be torn
	// down before the async socket write actually leaves the server, so the
	// ping silently never arrives. A short timeout keeps this from being
	// noticeable in the editor (typically resolves in well under a second)
	// while guaranteeing the request is actually sent.
	$response = wp_remote_post(
		ASTRO_REVALIDATE_URL,
		array(
			'timeout'   => 3,
			'blocking'  => true,
			'sslverify' => true,
			'headers'   => array(
				'X-Revalidate-Secret' => ASTRO_REVALIDATE_SECRET,
				'Content-Type'        => 'application/json',
			),
			'body'      => wp_json_encode( array( 'source' => 'wordpress' ) ),
		)
	);

	// Logged, not surfaced — a failed ping must never block or error out a
	// page save. The TTL fallback in src/lib/wp.ts still catches it either
	// way; this just makes a recurring failure visible in the PHP error log.
	if ( is_wp_error( $response ) ) {
		error_log( 'Astro revalidate webhook failed: ' . $response->get_error_message() );
	} elseif ( wp_remote_retrieve_response_code( $response ) !== 200 ) {
		error_log( 'Astro revalidate webhook returned HTTP ' . wp_remote_retrieve_response_code( $response ) );
	}
}

// Publish/update: fires on every save of a page or post — including
// Gutenberg's autosave ticks — so autosaves/revisions are skipped, and only
// content that's actually live (publish) triggers a ping. Same logic for
// both post types (the Astro /blog and page-tree caches purge together —
// see purgeCache() in src/lib/wp.ts), so one function backs both hooks.
function astro_maybe_revalidate_on_save( $post_id ) {
	if ( wp_is_post_autosave( $post_id ) || wp_is_post_revision( $post_id ) ) {
		return;
	}
	if ( get_post_status( $post_id ) !== 'publish' ) {
		return;
	}

	astro_trigger_revalidate();
}
add_action( 'save_post_page', 'astro_maybe_revalidate_on_save' );
add_action( 'save_post_post', 'astro_maybe_revalidate_on_save' );

// Trash: save_post_{page,post} never fires when content is moved to the
// trash, so catch that transition directly instead.
add_action( 'transition_post_status', function ( $new_status, $old_status, $post ) {
	if ( ! in_array( $post->post_type, array( 'page', 'post' ), true ) ) {
		return;
	}
	if ( $new_status !== 'trash' || $old_status === 'trash' ) {
		return;
	}

	astro_trigger_revalidate();
}, 10, 3 );

/**
 * Hardening, unrelated to the Astro integration above.
 *
 * XML-RPC is a legacy remote-publishing protocol this headless setup has no
 * use for — leaving it enabled is a well-known brute-force/DDoS-amplification
 * vector (pingback relay attacks) with no upside here.
 */
add_filter( 'xmlrpc_enabled', '__return_false' );

/**
 * The REST API's /wp/v2/users endpoint returns every user's login-derived
 * "slug", which is commonly the same as (or close to) their actual username
 * — a public username-enumeration vector feeding brute-force login attempts.
 * Only blocked for anonymous requests: a logged-in editor/admin session
 * (e.g. Gutenberg's author picker) still needs this endpoint and continues
 * to work normally.
 */
add_filter( 'rest_authentication_errors', function ( $result ) {
	if ( ! empty( $result ) ) {
		return $result; // don't override an existing auth error/success
	}

	$is_users_endpoint = false !== strpos( $_SERVER['REQUEST_URI'] ?? '', '/wp/v2/users' );
	if ( $is_users_endpoint && ! is_user_logged_in() ) {
		return new WP_Error(
			'rest_users_disabled',
			'The users endpoint is disabled for unauthenticated requests.',
			array( 'status' => 401 )
		);
	}

	return $result;
} );

/**
 * Forces `Cache-Control: no-store` on every REST API response, overriding
 * whatever is currently sending `public, max-age=604800` (observed directly
 * on this install — a full week of public caching on /wp/v2/pages, not
 * something WordPress core sets by default, so it's coming from somewhere
 * in the hosting stack). The Astro frontend depends on every REST fetch
 * being genuinely live: its own short in-memory cache (PAGE_TREE_CACHE_TTL
 * + the revalidate webhook, see src/lib/wp.ts) is what's supposed to govern
 * freshness — anything upstream caching the REST response for a week
 * silently defeats that no matter how often the app purges its own cache.
 */
add_filter( 'rest_pre_serve_request', function ( $served, $result, $request, $server ) {
	header( 'Cache-Control: no-store' );
	return $served;
}, 10, 4 );
