# Spec 11 fixture — Flask blueprint with 3 routes.
from flask import Blueprint

bp = Blueprint('api', __name__)


@bp.route('/users', methods=['GET'])
def list_users():
    return []


@bp.route('/users', methods=['POST'])
def create_user():
    return {}


@bp.route('/users/<int:user_id>', methods=['GET'])
def get_user(user_id):
    return {'id': user_id}
